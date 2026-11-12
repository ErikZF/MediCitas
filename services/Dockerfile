# Builds any MediCitas service. Run from the repository root:
#   docker build -f services/Dockerfile --build-arg SERVICE=edge-gateway -t medicitas/edge-gateway .
FROM node:22-bookworm-slim
ARG SERVICE=edge-gateway
WORKDIR /app

COPY . .
RUN npm ci && npm run build:packages && npm run build -w services/${SERVICE}

WORKDIR /app/services/${SERVICE}
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
