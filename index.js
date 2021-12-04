require('dotenv').config()
const { Telegraf } = require('telegraf')
const tesseract = require("node-tesseract-ocr")
const axios = require('axios')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { models } = require('./antispam-db')

const PHONE_REGEX = /(63|0*9)\s*(\d{3,4})\s*(\d{3,4})\s*(\d{3,4})/gmi
const MEDIA_STORAGE = "./storage/media"

try{
    fs.mkdirSync(MEDIA_STORAGE)
} catch(e) { }
    

const replyWithHelp = ctx => {
    ctx.reply('send me a screenshot of a spam text. make sure the phone number is visible along with the text message. in case the message is too long, copy the message and paste it here after the prompt')
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

bot.start(replyWithHelp)
bot.help(replyWithHelp)

const queue = []
let queueRunning = false

bot.on('message', async ctx => {

    const { message } = ctx?.update
    const { from, chat, photo, document } = message
    
    const getTelegramUser = () => models.TelegramUser.query().findById(from.id)
    let telegramUser = await getTelegramUser()
    const telegramUserData = {
        telegram_user_id: from.id,
        first_name: from.first_name,
        last_name: from.last_name,
        username: from.username,
        user_json: JSON.stringify(from),
    }
    if(!telegramUser){
        await models.TelegramUser.query().insert(telegramUserData)
        telegramUser = await getTelegramUser()
    } else{
        await models.TelegramUser.query().patch(telegramUserData)
    }

    const ALLOWED_TYPES = ["image/jpg", "image/png"]
    
    if(!photo?.length && !(ALLOWED_TYPES.includes(document?.mime_type))) return replyWithHelp(ctx)

    const messageInfo = await ctx.reply("your message has been queued...")
    const updateMessage = async text => await ctx.telegram.editMessageText(
        messageInfo.chat.id,
        messageInfo.message_id,
        undefined, text,
    )

    
    queue.push({
        ctx, message, from, chat, photo, document,
        updateMessage, messageInfo, telegramUser
    })

    if(!queueRunning) queueLoop()
})

async function processImageRequest({ ctx, message, from, chat, photo, document, updateMessage, messageInfo, telegramUser }){
    await updateMessage("downloading image...")

    try{
        let photoUrl = null
        let fileId = null
        if(document){
            fileId = document.file_id
            photoUrl = (await ctx.telegram.getFileLink(fileId)).href
        } else{
            const largetPhoto = photo.sort((a, b) => a.file_size - b.file_size).pop()
            fileId = largetPhoto.file_id
            photoUrl = (await ctx.telegram.getFileLink(fileId)).href
        }
    
    
        const ext = photoUrl.split(".").pop()
        const fileName = path.join(MEDIA_STORAGE, [from.username, fileId, ext].join("."))
        
        await axios({url: photoUrl, responseType: 'stream'}).then(response => {
            return new Promise((resolve, reject) => {
                response.data.pipe(fs.createWriteStream(fileName))
                    .on('finish', resolve)
                    .on('error', reject)
            });
        })

        await updateMessage("logging telegram message...")

        await models.TelegramMessage.query().insert({
            telegram_message_id: message.message_id,
            telegram_user_id: from.id,
            message_json: JSON.stringify(message),
        })
    
        await updateMessage("reading image...")

        let imageBuffer = await fsp.readFile(fileName)

        await updateMessage("manipulating image buffer...")

        const contrast = 2

        imageBuffer = await require('sharp')(imageBuffer)
            .resize({width: 3000})
            .linear(contrast, -(128 * contrast) + 128)
            .sharpen(5)
            .toBuffer()
        
        // await fsp.writeFile(fileName+".manip."+ext, imageBuffer)

        await updateMessage("running tesseract...")
    
        const tsv = await tesseract.recognize(imageBuffer, {
            lang: "eng",
            oem: 3,
            psm: 3,
            presets: ["tsv"],
        })
    
        await updateMessage("parsing text...")
    
        let data = (new (require('tsv').Parser)("\t", { header: true })).parse(tsv.trim())
        data = data.filter(part => Number(part.conf) >= 1)
    
        console.table(data)
    
        let lines = {}
        for(let part of data){
            if(!lines[part.block_num]) lines[part.block_num] = []
            lines[part.block_num].push(part.text)
        }
        lines = Object.values(lines).map(line => line.join(" "))
        
        // We assume that the phone number can be found at the top
        let phoneNumber = null
        for(let i = 0; i < lines.length / 2; i++){
            const line = lines[i]
            const match = line.match(PHONE_REGEX)
            if(match){
                phoneNumber = match.shift()
                lines.splice(0, i + 1)
                break
            }
        }
    
        if(!phoneNumber) {
            await fsp.rm(fileName)
            await updateMessage("can't find the phone number :/ try sending again (or send as file)")
            return 
        }
    
        
        // Prune lines with more symbols
        lines = lines.filter(line => {
            const ok = line.match(/[a-z0-9]/gmi)?.length || 0
            const notOk = line.match(/[^a-z0-9]/gmi)?.length || 0
            return ok > notOk
        })

        const text = lines.join("\n")
        
        console.table(lines)
        const numbersFound = [phoneNumber].concat(lines).join(" ").match(PHONE_REGEX)

        await updateMessage(`logging spammers...`)
        for(let phone_number of numbersFound){
            phone_number = models.Spammer.formatPhoneNumber(phone_number)
            let spammer = await models.Spammer.query().findById(phone_number)
            if(!spammer){
                await updateMessage(`logging spammer (${phone_number})...`)
                await models.Spammer.query().insert({ 
                    spammer_id: phone_number,
                    phone_number,
                })
            }
            await models.SpammerMessage.query().insert({
                spammer_id: phone_number,
                telegram_user_id: from.id,
                tesseract_tsv: tsv,
                tesseract_txt: text,
                file_id: fileId,
                file_path: fileName,
            })
        }
        
        await updateMessage([
            `NUMBERS: ${numbersFound}`,
            `MESSAGE: \n${text}`
        ].join("\n\n"))
    } catch(e){
        await updateMessage(`something went wrong...\n\n${e.name}: ${e.message}`)
        console.error(e)
    }
}

async function queueLoop(){
    queueRunning = true
    const fullContext = queue.shift()
    for(let i = 0; i < queue.length; i++){
        const queuedContext = queue[i]
        await queuedContext.updateMessage(`waiting for ${i+1} other requests...`)
    }
    await processImageRequest(fullContext)
    if(queue.length) queueLoop()
    else queueRunning = false
}

bot.launch()
console.log("The bot is running...")
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))