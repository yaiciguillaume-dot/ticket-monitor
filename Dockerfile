# Image officielle Playwright : Chromium + dépendances système déjà installés.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
# Pas de postinstall (chromium déjà présent dans l'image)
RUN npm install --omit=dev --ignore-scripts

COPY . .

EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
