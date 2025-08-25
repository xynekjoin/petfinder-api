# Imagen base de Node.js
FROM node:18-alpine

# Establecer directorio de trabajo
WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package.json ./
RUN npm install --production

# Copiar el resto del código
COPY . .

# Exponer el puerto en el que correrá Express
EXPOSE 3000

# Comando para iniciar la app
CMD ["npm", "start"]
