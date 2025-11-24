import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { FirebaseService } from './firebase.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [FirebaseService],
})
export class AppModule {}

