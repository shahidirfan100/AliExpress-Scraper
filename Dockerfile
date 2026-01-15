FROM apify/actor-node-playwright-chrome:22

COPY package*.json ./
RUN npm install --include=dev --audit=false

COPY . ./
