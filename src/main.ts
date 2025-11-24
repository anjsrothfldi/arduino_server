import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Enable CORS so dummy.py (if it were a browser) or other clients can access
  app.enableCors();
  await app.listen(3000);
  console.log(`Server is running on: ${await app.getUrl()}`);
}
bootstrap();
