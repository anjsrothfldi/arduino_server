import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import express, { Express } from 'express';
import * as functions from 'firebase-functions';

const server = express();

export const createNestServer = async (expressInstance: Express) => {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressInstance),
  );
  // Enable CORS
  app.enableCors();
  await app.init();
  return app;
};

createNestServer(server)
  .then(() => console.log('Nest Ready'))
  .catch(err => console.error('Nest broken', err));

// Export 'api' function to Firebase
export const api = functions.https.onRequest(server);
