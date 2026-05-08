FROM node:20-slim
RUN apt-get update && apt-get install -y libssl-dev curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc
EXPOSE 3001
CMD ["node", "dist/index.js"]
