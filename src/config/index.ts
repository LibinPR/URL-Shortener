import dotenv from 'dotenv'

//load .env into process
//it shd happen before anything
dotenv.config();

//Helper : throws at startup if required variable is missing
//Fail-fast : fail imeediadelty than in middle
function required(key: string): string {
    const value = process.env[key];

    if(value === undefined || value ==='') {
        throw new Error(`Missing required environment variable : ${key}`);
    }
    return value;
}

//Helper : returns value or safe default 
function optional(key: string , defaultValue: string): string {
    return process.env[key] ?? defaultValue;
}

export const config = {
    server:{
        port: parseInt(optional('PORT' , '3000') , 10),
        nodeEnv: optional('NODE_ENV' , 'development'),
        baseUrl: optional('BASE_URL' , 'http://localhost:3000'),
        isDev: optional('NODE_ENV' , 'development') === 'development',
    },

    db: {
    host: optional('DB_HOST', 'localhost'),
    port: parseInt(optional('DB_PORT', '5432'), 10),
    database: optional('DB_NAME', 'urlshortener'),
    user: optional('DB_USER', 'postgres'),
    password: optional('DB_PASSWORD', 'postgres123'),
    ssl: optional('DB_SSL' , 'false') === 'true',
    poolMin: 2,
    poolMax: 10,
  },

   redis: {
    url: process.env['REDIS_URL']??null,
    host: optional('REDIS_HOST', 'localhost'),
    port: parseInt(optional('REDIS_PORT', '6379'), 10),
    ttlSeconds: parseInt(optional('REDIS_TTL_SECONDS', '86400'), 10),
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    max: parseInt(optional('RATE_LIMIT_MAX', '60'), 10),
  },
} as const;