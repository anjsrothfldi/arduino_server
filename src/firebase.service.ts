import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService {
  private db: admin.firestore.Firestore;

  constructor() {
    // Initialize Firebase Admin SDK
    // In Cloud Functions, this uses Application Default Credentials automatically.
    // For local development, you might need to set GOOGLE_APPLICATION_CREDENTIALS env var.
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    this.db = admin.firestore();
  }

  private memoryStore: Record<number, any> = {}; // Temporary in-memory store

  async saveEnvironmentData(data: any) {
    console.log("Received data:", data);
    
    const payload = {
        dataId: Date.now(),
        sessionId: 5001, // Hardcoded demo session ID
        userId: 1024,    // Hardcoded user ID
        timestamp: new Date().toISOString(),
        sampleSeq: 0, // Optional
        temperature: data.temperature,
        humidity: data.humidity,
        co2: data.gasValue, // Mapping gasValue to co2 for demo
        heartRate: 0, // Dummy doesn't send HR
        spo2: 98,
        lightLux: 500,
        batteryVoltage: 3.8,
        rawPayload: data,
        createdAt: admin.firestore.Timestamp.now(),
        validated: true
    };

    // Save to in-memory store for immediate polling access
    this.memoryStore[payload.sessionId] = payload;
    
    return { success: true, id: 'memory-only' };
  }

  async getLatestEnvironmentData(sessionId: number) {
    // Check memory store first for fastest access
    if (this.memoryStore[sessionId]) {
        const data = this.memoryStore[sessionId];
        return {
             ...data,
            createdAt: data.createdAt instanceof admin.firestore.Timestamp ? data.createdAt.toDate().toISOString() : data.createdAt
        };
    }

    return null;
  }
}
