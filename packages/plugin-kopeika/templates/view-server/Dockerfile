FROM oven/bun:1
WORKDIR /app
COPY server.ts ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
