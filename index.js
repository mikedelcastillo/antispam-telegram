require('dotenv').config()
const { Telegraf } = require('telegraf')
const tesseract = require("node-tesseract-ocr")
const axios = require('axios')
const fs = require('fs')
const { collapseTextChangeRangesAcrossMultipleVersions } = require('typescript')

const PHONE_REGEX = /(63|0*9)\s*(\d{3,4})\s*(\d{3,4})\s*(\d{3,4})/gmi

const replyWithHelp = ctx => {
    ctx.reply('send me a screenshot of a spam text. make sure the phone number is visible along with the text message. in case the message is too long, copy the message and paste it here after the prompt')
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)

bot.start(replyWithHelp)
bot.help(replyWithHelp)

bot.on('message', async ctx => {
    const { message } = ctx?.update
    const { from, chat, photo, document } = message

    console.log(message)

    const ALLOWED_TYPES = ["image/jpg", "image/png"]
    
    if(!photo?.length && !(ALLOWED_TYPES.includes(document?.mime_type))) return replyWithHelp(ctx)

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
    const fileName = require('path').join("./storage", [fileId, ext].join("."))
    
    await axios({url: photoUrl, responseType: 'stream'}).then(response => {
        return new Promise((resolve, reject) => {
            response.data.pipe(fs.createWriteStream(fileName))
                .on('finish', resolve)
                .on('error', reject)
        });
    })

    const tsv = await tesseract.recognize(fileName, {
        lang: "eng",
        oem: 3,
        psm: 3,
        presets: ["tsv"],
    })

    let data = (new (require('tsv').Parser)("\t", { header: true })).parse(tsv.trim())
    data = data.filter(part => Number(part.conf) >= 25)

    let lines = {}
    for(let part of data){
        if(!lines[part.block_num]) lines[part.block_num] = []
        lines[part.block_num].push(part.text)
    }
    lines = Object.values(lines).map(line => line.join(" "))
    
    // We assume that the phone number can be found at the top
    let phoneNumber = null
    for(let i = 0; i < lines.length; i++){
        const line = lines[i]
        const match = line.match(PHONE_REGEX)
        if(match){
            phoneNumber = match.shift()
            lines.splice(0, i + 1)
            break
        }
    }

    if(!phoneNumber) return ctx.reply("can't find the phone number :/ try sending again (or send as file)")

    // Prune lines with more symbols
    lines = lines.filter(line => {
        const ok = line.match(/[a-z0-9]/gmi)?.length || 0
        const notOk = line.match(/[^a-z0-9]/gmi)?.length || 0
        console.log(line, ok, notOk)
        return ok > notOk
    })

    console.table(lines)
    const numbersFound = [phoneNumber].concat(lines).join(" ").match(PHONE_REGEX)

    ctx.reply([
        `NUMBERS: ${numbersFound}`,
        `MESSAGE: \n${lines.join("\n")}`
    ].join("\n\n"))
})

bot.launch()
console.log("The bot is running...")
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))