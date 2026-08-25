FROM node:20-alpine AS build
WORKDIR /app
# Accept API/WS URLs at build time so React bakes the correct endpoints into the bundle
ARG REACT_APP_API_URL=http://localhost:4000/api
ENV REACT_APP_API_URL=$REACT_APP_API_URL
ARG REACT_APP_WS_URL=ws://localhost:4000/ws
ENV REACT_APP_WS_URL=$REACT_APP_WS_URL
COPY package.json ./
RUN npm install
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
