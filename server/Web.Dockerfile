FROM node:24.22.1-bookworm

RUN git --version && ssh -V
WORKDIR /opt/infohub
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY core/ ./core/
COPY cli/ ./cli/
COPY sync/ ./sync/
COPY server/ ./server/
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/web.mjs"]
