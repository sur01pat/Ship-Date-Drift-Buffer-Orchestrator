FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src ./src
RUN mkdir -p data
EXPOSE 4000
CMD ["node", "src/index.js"]
