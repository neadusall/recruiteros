# Lume jobs backend — tiny, dependency-free Node service.
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY seed ./seed
ENV PORT=3000
EXPOSE 3000
# Run as the built-in non-root user; /data is a mounted volume owned by root,
# so we keep root here for write access to the volume (matches the other services).
CMD ["node", "server.js"]
