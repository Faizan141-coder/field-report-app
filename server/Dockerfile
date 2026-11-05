FROM node:22-slim
WORKDIR /srv
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV DATA_DIR=/srv/data
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
