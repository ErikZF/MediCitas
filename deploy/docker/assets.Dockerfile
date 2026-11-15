# Packages database SQL schemas/seeds and Keycloak realm/user seeds into an
# immutable, non-root image for Kubernetes initContainers and seed Jobs.
# Build from the repository root:
#   docker build -f deploy/docker/assets.Dockerfile -t medicitas/assets:local .
FROM node:22-alpine

WORKDIR /assets
COPY --chown=node:node database /assets/database
COPY --chown=node:node keycloak /assets/keycloak

USER node
