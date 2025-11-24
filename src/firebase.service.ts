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

    try {
        const docRef = await this.db.collection('EnvironmentData').add(payload);
        console.log("Document written with ID: ", docRef.id);
        return { success: true, id: docRef.id };
    } catch (e) {
        console.error("Error adding document: ", e);
        return { success: false, error: e };
    }
  }
}
