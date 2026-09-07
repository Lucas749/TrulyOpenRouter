FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_PRIVY_APP_ID=""
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
RUN npm run build
# Runtime needs schema.sql at cwd (/app) for ensureSchema.
COPY --from=build /app/schema.sql ./schema.sql

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3002
CMD ["node", "server.js"]
