FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# DC_ACCOUNTS_PATH must be a persistent volume
ENV DC_ACCOUNTS_PATH=/data
ENV CHATMAIL_DOMAIN=chat.serey.io
ENV CHAT_SERVICE_PORT=4040

VOLUME ["/data"]
EXPOSE 4040

CMD ["node", "index.js"]
