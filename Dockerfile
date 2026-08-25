FROM node:22-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY Dentalab_Licitaciones_Web_v1.1_GitHub_Render.zip /tmp/app.zip
RUN unzip /tmp/app.zip -d /app && mv /app/Dentalab_Licitaciones_Web_v1.0 /app/web && rm /tmp/app.zip
WORKDIR /app/web
RUN npm install --omit=dev
ENV NODE_ENV=production
EXPOSE 8788
CMD ["npm","start"]
