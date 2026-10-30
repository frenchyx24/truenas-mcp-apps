FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3004/health').then(r=>{if(!r.ok)throw r.status})"
CMD ["node", "server.js"]
