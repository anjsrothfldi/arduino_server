import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Controller()
export class AppController {
  constructor(private readonly firebaseService: FirebaseService) {}

  @Post('receive-data')
  async receiveData(@Body() data: any) {
    return this.firebaseService.saveEnvironmentData(data);
  }

  @Get('sensor-data/:sessionId')
  async getSensorData(@Param('sessionId') sessionId: string) {
    return this.firebaseService.getLatestEnvironmentData(Number(sessionId));
  }
}

