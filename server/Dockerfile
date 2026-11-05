FROM node:22-slim
WORKDIR /srv
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Hugging Face runs containers as a non-root user, so keep data in /tmp.
ENV DATA_DIR=/tmp/data PORT=4000
EXPOSE 4000
CMD ["npx", "tsx", "src/index.ts"]
