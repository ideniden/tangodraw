FROM node:14-alpine AS build

WORKDIR /draw

COPY package.json yarn.lock ./
RUN yarn --ignore-optional --network-timeout 600000

ARG NODE_ENV=production

COPY . .
RUN yarn build:app:docker

EXPOSE 3001
CMD ["yarn", "start"]
