# Production image for both the web app and the worker (same image, different command).
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# tsx is needed at runtime to run the worker from TypeScript; prisma CLI for migrate deploy.
RUN npm ci --omit=dev && npm i --no-save tsx@4 && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/build ./build
COPY schema.prisma migrations ./
COPY app ./app
COPY worker ./worker
COPY tsconfig.json ./
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
