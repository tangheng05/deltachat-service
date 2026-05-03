FROM node:20.19.1-alpine3.21

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4040/health || exit 1

CMD ["node", "index.js"]
