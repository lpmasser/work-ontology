FROM node:24.22.1-bookworm

# The official full Node image includes Git and the OpenSSH client.
RUN git --version && ssh -V
WORKDIR /opt/infohub
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY core/ ./core/
COPY cli/ ./cli/
COPY sync/ ./sync/
RUN npm link --omit=dev --no-audit --no-fund
CMD ["infohub", "sync", "run"]
