# Imagen base de Node.js
FROM node:18

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia los archivos de definición de dependencias
COPY package*.json ./

# Instala dependencias
RUN npm install

# Copia el resto del código al contenedor
COPY . .

# Expone el puerto que usará Express
EXPOSE 3000

# Comando por defecto para iniciar la app
CMD ["npm", "start"]
