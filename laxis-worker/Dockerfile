# Laxis worker — headless Chromium that enriches CSVs through app.laxis.tech.
# The official Playwright image already ships the matching browsers, so there is no
# browser download step at build time.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install only the npm side of Playwright (browsers are baked into the base image).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
