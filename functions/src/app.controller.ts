import { Controller, Post, Body } from '@nestjs/common';
import { FirebaseService } from './firebase.service';

@Controller()
export class AppController {
  constructor(private readonly firebaseService: FirebaseService) {}

  @Post('receive-data')
  async receiveData(@Body() data: any) {
    return this.firebaseService.saveEnvironmentData(data);
  }
}

