FROM node:22-alpine

WORKDIR /app

COPY . .

RUN cd server && npm install
RUN cd client && npm install && npm run build
RUN cp -r client/build/* server/public/

CMD ["node", "server/index.js"]