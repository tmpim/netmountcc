FROM node:20-alpine

WORKDIR /netmountcc/

COPY package*.json ./
COPY tsconfig.json ./

COPY public ./public
COPY src /netmountcc/src
COPY .env.example .env

RUN npm install
RUN npx tsc

EXPOSE 4000

CMD ["node", "./bin/index.js"]
