FROM node:16

RUN apt-get update -y && apt-get install -y
RUN apt-get install -y tesseract-ocr

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production
COPY . .

CMD [ "node", "index.js" ]