FROM node:26.7
WORKDIR /app

COPY . .
RUN ["npm", "install"]

EXPOSE 3000
CMD ["node", "server.ts"]
