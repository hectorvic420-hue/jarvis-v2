# Dockerfile — Google Cloud Run
FROM node:20-alpine

WORKDIR /app

# Copiar package y dependencias primero (para cache)
COPY package*.json ./
RUN npm install --production

# Copiar código compilado
COPY dist ./dist

# Crear directorio para landings (persistent disk o Cloud Storage)
RUN mkdir -p /app/landings /app/data/db

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "dist/index.js"]
