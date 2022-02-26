FROM node:16-alpine

RUN apk --update --no-cache add \
  tzdata \
  && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
  && apk del tzdata \
  && apk add git

RUN npm install -g aws-cdk@2.12.0