import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Controller()
export class AppController {
  constructor(private readonly firebaseService: FirebaseService) {}

  @Post('signup')
  async signup(@Body() body: any) {
    return this.firebaseService.signup(body);
  }

  @Post('login')
  async login(@Body() body: any) {
    return this.firebaseService.login(body);
  }

  @Post('receive-data')
  async receiveData(@Body() data: any) {
    return this.firebaseService.saveEnvironmentData(data);
  }

  @Get('sensor-data/:userId')
  async getSensorData(@Param('userId') userId: string) {
    return this.firebaseService.getLatestEnvironmentData(userId);
  }

  @Post('start-session')
  async startSession(@Body() body: any) {
    return this.firebaseService.startSession(body);
  }

  @Post('save-session')
  async saveSession(@Body() body: any) {
    return this.firebaseService.saveSession(body);
  }

  @Get('session-dates/:userId')
  async getSessionDates(@Param('userId') userId: string) {
    return this.firebaseService.getSessionDates(userId);
  }

  @Get('sessions/:userId/:date')
  async getSessionsByDate(@Param('userId') userId: string, @Param('date') date: string) {
    return this.firebaseService.getSessionsByDate(userId, date);
  }

  @Post('stats/:userId')
  async getStats(@Param('userId') userId: string, @Body() body: { period: 'weekly' | 'monthly' }) {
    return this.firebaseService.getStats(userId, body.period);
  }

  @Post('mock-data/:userId')
  async generateMockData(@Param('userId') userId: string) {
    return this.firebaseService.generateMockData(userId);
  }

  @Post('reset-session/:userId')
  async resetSession(@Param('userId') userId: string) {
    return this.firebaseService.resetSession(userId);
  }

  @Get('user/:userId')
  async getUser(@Param('userId') userId: string) {
    return this.firebaseService.getUser(userId);
  }
}
