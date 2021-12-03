require('dotenv').config()

//https://github.com/knex/knex/issues/2952

const config = {
  client: "mysql",
  connection: {
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    timezone: '+00:00',
  },
  migrations: {
    directory: "./antispam-db/migrations",
  },
  seeds: {
    directory: "./antispam-db/seeds",
  },
}

module.exports = {
  ...config,
  development: config,
  staging: config,
  production: config,
}
