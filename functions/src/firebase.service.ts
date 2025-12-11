import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

interface UserSessionState {
  startTime: number;
  baseline: { temp: number; hum: number; gas: number; hr: number; hi: number };
  bmi: number;
  plannedIntensity: number;
}

@Injectable()
export class FirebaseService {
  private memoryStore: Record<string, any> = {};
  private sessionStore: Record<string, UserSessionState> = {};
  private intensityHistory: Record<string, number[]> = {}; // For smoothing intensity values
  private db: admin.firestore.Firestore;
  private readonly hiTrendThreshold = 0.5; // °C delta across 10 samples
  private readonly gasTrendThreshold = 50; // ppm delta across 10 samples
  private readonly intensityHistorySize = 5; // Smooth over last 5 values

  constructor() {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    this.db = admin.firestore();
  }

  private generateSalt(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private hashPassword(password: string, salt: string): string {
    return crypto.createHash('sha256').update(password + salt).digest('hex');
  }
  
  private computeHeatIndex(t: number, rh: number): number {
    // NOAA Heat Index formula (Rothfusz regression, converted to Celsius)
    // Same formula as frontend for consistency
    if (t == null || rh == null) return t ?? 0;
    const T = t;
    const R = Math.min(100, Math.max(0, rh));
    
    // Convert to Fahrenheit for calculation
    const T_f = T * 9 / 5 + 32;
    
    // Rothfusz regression
    const HI_f =
      -42.379 +
      2.04901523 * T_f +
      10.14333127 * R -
      0.22475541 * T_f * R -
      0.00683783 * T_f * T_f -
      0.05481717 * R * R +
      0.00122874 * T_f * T_f * R +
      0.00085282 * T_f * R * R -
      0.00000199 * T_f * T_f * R * R;
    
    // Convert back to Celsius
    const HI_c = (HI_f - 32) * 5 / 9;
    
    // Round to 1 decimal place
    return Math.round(HI_c * 10) / 10;
  }

  private getBMISensitivityFactor(bmi: number) {
    if (bmi < 18.5) return 0.8;
    if (bmi < 25.0) return 1.0;
    if (bmi < 30.0) return 1.2;
    return 1.3;
  }

  // --- Auth Logic ---
  async signup(body: any) {
    const { username, name, password, age, gender, height, weight } = body;
    let { email } = body;

    if (!email || !password || !username) return { success: false, message: 'Missing required fields' };

    email = email.trim().toLowerCase();
    
    const emailQuery = await this.db.collection('Users').where('email', '==', email).get();
    if (!emailQuery.empty) return { success: false, message: 'Email already exists' };

    const usernameQuery = await this.db.collection('Users').where('username', '==', username).get();
    if (!usernameQuery.empty) return { success: false, message: 'Username already exists' };

    const userId = crypto.randomUUID();
    const passwordSalt = this.generateSalt();
    const passwordHash = this.hashPassword(password, passwordSalt);
    const now = new Date().toISOString();

    const newUser = {
        userId, username, name: name || "", email, passwordHash, passwordSalt,
        age: Number(age), gender, height: Number(height), weight: Number(weight),
        role: "user", isActive: true, profileImageUrl: "", joinedAt: now,
        createdAt: now, updatedAt: now, lastLoginAt: null, deletedAt: null
    };

    await this.db.collection('Users').doc(userId).set(newUser);
    
    // Return full user data (excluding sensitive fields)
    const { passwordHash: _, passwordSalt: __, ...userInfo } = newUser;
    return { success: true, user: userInfo };
  }

  async login(body: any) {
    const { username, password } = body;
    const userQuery = await this.db.collection('Users').where('username', '==', username).limit(1).get();

    if (userQuery.empty) return { success: false, message: 'User not found' };

    const userData = userQuery.docs[0].data();
    const hash = this.hashPassword(password, userData.passwordSalt);
    
    if (hash !== userData.passwordHash) return { success: false, message: 'Wrong password' };

    await this.db.collection('Users').doc(userData.userId).update({ lastLoginAt: new Date().toISOString() });
    
    // Return full user data (excluding sensitive fields)
    const { passwordHash, passwordSalt, ...userInfo } = userData;
    return { success: true, user: userInfo };
  }

  async getUser(userId: string) {
    const userDoc = await this.db.collection('Users').doc(userId).get();
    if (!userDoc.exists) return { success: false, message: 'User not found' };
    
    const userData = userDoc.data();
    // Exclude sensitive fields
    const { passwordHash, passwordSalt, ...userInfo } = userData;
    return { success: true, user: userInfo };
  }

  // --- Data Logic ---

  // 1. Start Session (with Baseline from Client)
  async startSession(body: any) {
    const { userId, plannedIntensity, baseline } = body;
    
    let bmi = 22.0;
    try {
        const userDoc = await this.db.collection('Users').doc(userId).get();
        if (userDoc.exists) {
            const u = userDoc.data();
            const h = (u?.height || 175) / 100;
            const w = u?.weight || 70;
            if (h > 0) bmi = w / (h * h);
        }
    } catch (e) {}

    // Save Session State
    this.sessionStore[userId] = {
        startTime: Date.now(),
        baseline: {
            ...baseline,
            hi: this.computeHeatIndex(baseline.temp, baseline.hum)
        },
        bmi,
        plannedIntensity: Number(plannedIntensity) || 1
    };
    
    console.log(`Session STARTED for ${userId}. Baseline:`, baseline);
    return { success: true, message: "Session started on server" };
  }

  // 2. Save Data (Calculate Intensity if Session Active)
  // Note: EKF filtering is already done on Arduino (sensor.ino), so we use the filtered values directly
  async saveEnvironmentData(data: any) {
    const userId = data.userId;
    if (!userId) return { success: false, message: 'userId required' };

    const parseNumber = (value: any) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };

    // Arduino already sends filtered values (filteredT, filteredH, filteredG) + extra insights
    const { temperature, humidity, gasValue, heartRate } = data; 
    const predictedHIValue = parseNumber(data.predictedHI) ?? 0;
    const predictedGasValue = parseNumber(data.predictedGas) ?? 0;
    // reportedHI 제거: 서버에서 항상 재계산하므로 아두이노 값은 참고용으로만 사용

    // Only process if session is active
    const session = this.sessionStore[userId];
    let calculatedIntensity = 0;
    let statusMessage = "대기 중 (운동 시작 전)";
    const trendMessages: string[] = [];

    // Use the filtered values directly from Arduino (no additional EKF filtering)
    const fTemp = Number(temperature);
    const fHum = Number(humidity);
    const fGas = Number(gasValue);

    if (session) {
        // Validate baseline values
        if (!session.baseline || 
            typeof session.baseline.hi !== 'number' || 
            typeof session.baseline.gas !== 'number' || 
            typeof session.baseline.hr !== 'number' ||
            isNaN(session.baseline.hi) || 
            isNaN(session.baseline.gas) || 
            isNaN(session.baseline.hr)) {
            console.error(`[Intensity Calc] Invalid baseline for user ${userId}:`, session.baseline);
            calculatedIntensity = 1;
            statusMessage = "기준값 설정 중...";
            // Continue with default values
        } else {
            // Calculate Intensity using improved formula for stability
            // 서버에서 항상 재계산하여 일관성 보장 (아두이노 값은 참고용)
            const fHI = this.computeHeatIndex(fTemp, fHum);
            const sensitivity = this.getBMISensitivityFactor(session.bmi);
            
            // Calculate normalized deltas (0-1 range)
            const deltaHI = Math.abs(fHI - session.baseline.hi); 
            const deltaGas = Math.max(0, fGas - session.baseline.gas);
            const deltaHR = Math.max(0, (heartRate || 0) - session.baseline.hr);

            // Debug: Log baseline and current values
            console.log(`[Intensity Calc] Baseline: HI=${session.baseline.hi.toFixed(2)}, Gas=${session.baseline.gas.toFixed(0)}, HR=${session.baseline.hr.toFixed(0)}`);
            console.log(`[Intensity Calc] Current: HI=${fHI.toFixed(2)}, Gas=${fGas.toFixed(0)}, HR=${(heartRate || 0).toFixed(0)}`);
            console.log(`[Intensity Calc] Deltas: HI=${deltaHI.toFixed(2)}, Gas=${deltaGas.toFixed(0)}, HR=${deltaHR.toFixed(0)}, Sensitivity=${sensitivity.toFixed(2)}`);

            // Normalize each component to 0-1 range using square root for smoother scaling
            // Higher sensitivity = lower threshold (more sensitive)
            // Prevent division by zero or negative values
            const hiDivisor = Math.max(0.1, 3.0 * sensitivity); // Minimum 0.1 to prevent division issues
            const gasDivisor = Math.max(1.0, 100.0 * sensitivity); // Minimum 1.0
            const hrDivisor = 60.0;
            
            const normalizedHI = Math.min(1.0, Math.sqrt(Math.max(0, deltaHI) / hiDivisor)); // Max 3°C change = 1.0
            const normalizedGas = Math.min(1.0, Math.sqrt(Math.max(0, deltaGas) / gasDivisor)); // Max 100ppm change = 1.0
            const normalizedHR = Math.min(1.0, Math.sqrt(Math.max(0, deltaHR) / hrDivisor)); // Max 60bpm change = 1.0

            console.log(`[Intensity Calc] Normalized: HI=${normalizedHI.toFixed(3)}, Gas=${normalizedGas.toFixed(3)}, HR=${normalizedHR.toFixed(3)}`);

            // Weighted average (심박수 50%, 체감온도 25%, 공기질 25%)
            let baseIntensity = (normalizedHR * 0.5 + normalizedHI * 0.25 + normalizedGas * 0.25);
            
            // Apply trend adjustments (more gradual than simple +1)
            let trendAdjustment = 0;
            if (Math.abs(predictedHIValue) >= this.hiTrendThreshold) {
                const trendStrength = Math.min(1.0, Math.abs(predictedHIValue) / 2.0); // 0-1 range
                trendAdjustment += trendStrength * 0.3; // Max +0.3
                trendMessages.push(predictedHIValue > 0 ? "체감 온도가 빠르게 상승 중" : "체감 온도가 빠르게 하락 중");
            }

            if (predictedGasValue >= this.gasTrendThreshold) {
                const trendStrength = Math.min(1.0, predictedGasValue / 100.0); // 0-1 range
                trendAdjustment += trendStrength * 0.2; // Max +0.2
                trendMessages.push("공기질 악화 추세 감지");
            }

            // Combine base intensity with trend adjustment
            let rawIntensity = baseIntensity + trendAdjustment;
            rawIntensity = Math.min(1.0, rawIntensity); // Cap at 1.0

            console.log(`[Intensity Calc] Base=${baseIntensity.toFixed(3)}, Trend=${trendAdjustment.toFixed(3)}, Raw=${rawIntensity.toFixed(3)}`);

            // Map to 1-10 scale with non-linear curve for better distribution
            // Using power curve: intensity^0.8 to compress high values slightly
            let intensity = 1 + (rawIntensity ** 0.8) * 9;
            
            console.log(`[Intensity Calc] Before smoothing: ${intensity.toFixed(2)}`);

            // Apply smoothing using moving average of last N values
            if (!this.intensityHistory[userId]) {
                this.intensityHistory[userId] = [];
            }
            this.intensityHistory[userId].push(intensity);
            if (this.intensityHistory[userId].length > this.intensityHistorySize) {
                this.intensityHistory[userId].shift();
            }
            
            // Use weighted average (recent values have more weight)
            const history = this.intensityHistory[userId];
            if (history.length > 1) {
                let weightedSum = 0;
                let weightSum = 0;
                history.forEach((val, idx) => {
                    const weight = idx + 1; // More recent = higher weight
                    weightedSum += val * weight;
                    weightSum += weight;
                });
                intensity = weightedSum / weightSum;
            }

            // Round to nearest integer and clamp
            intensity = Math.round(intensity);
            if (intensity < 1) intensity = 1;
            if (intensity > 10) intensity = 10;

            console.log(`[Intensity Calc] Final intensity: ${intensity}`);

            calculatedIntensity = intensity;

            // Set status message based on calculated intensity
            if (trendMessages.length > 0) {
                statusMessage = trendMessages.join(" · ");
            } else if (calculatedIntensity >= 8) statusMessage = "경고: 운동 강도가 높습니다! (Overexertion)";
            else if (calculatedIntensity >= 4) statusMessage = "좋습니다! 적절한 운동 강도입니다.";
            else statusMessage = "가벼운 운동 중입니다.";
        }
        // Note: Invalid baseline case is already handled above (lines 179-181)
    } else {
        // No active session -> Just return raw data or 0 intensity
        calculatedIntensity = 0;
        statusMessage = "측정 준비 완료";
    }
    
    // 위험 상황 감지 (알림용)
    let alertLevel: 'none' | 'warning' | 'critical' = 'none';
    let alertMessage: string | null = null;
    const alerts: string[] = [];
    
    if (session && session.baseline) {
        // 서버에서 항상 재계산하여 일관성 보장 (아두이노 값은 참고용)
        const fHI = this.computeHeatIndex(fTemp, fHum);
        const deltaHI = fHI - session.baseline.hi;
        const deltaGas = fGas - session.baseline.gas;
        
        // 온도 급상승 감지 (3°C 이상 상승)
        if (deltaHI >= 3.0) {
            alerts.push(`체감온도 급상승: ${deltaHI.toFixed(1)}°C 상승`);
            alertLevel = 'critical';
        } else if (deltaHI >= 2.0) {
            alerts.push(`체감온도 상승: ${deltaHI.toFixed(1)}°C 상승`);
            if (alertLevel === 'none') alertLevel = 'warning';
        }
        
        // 가스 이상 감지 (100ppm 이상 증가)
        if (deltaGas >= 100) {
            alerts.push(`공기질 악화: ${deltaGas.toFixed(0)}ppm 증가`);
            if (alertLevel !== 'critical') alertLevel = 'critical';
        } else if (deltaGas >= 50) {
            alerts.push(`공기질 주의: ${deltaGas.toFixed(0)}ppm 증가`);
            if (alertLevel === 'none') alertLevel = 'warning';
        }
        
        // 운동강도 과도 (8 이상)
        if (calculatedIntensity >= 8) {
            alerts.push(`운동강도 과도: ${calculatedIntensity}/10`);
            if (alertLevel !== 'critical') alertLevel = 'critical';
        } else if (calculatedIntensity >= 7) {
            alerts.push(`운동강도 높음: ${calculatedIntensity}/10`);
            if (alertLevel === 'none') alertLevel = 'warning';
        }
    }
    
    if (alerts.length > 0) {
        alertMessage = alerts.join(' | ');
    }
    
    const payload = {
        dataId: Date.now(),
        userId,
        sessionId: 5001, 
        timestamp: new Date().toISOString(),
        temperature: Number(fTemp.toFixed(1)),
        humidity: Number(fHum.toFixed(1)),
        co2: Number(fGas.toFixed(0)),
        heartRate: heartRate || 0,
        // 서버에서 항상 재계산하여 일관성 보장 (아두이노 값은 참고용)
        heatIndex: Number(this.computeHeatIndex(fTemp, fHum).toFixed(1)),
        predictedHI: Number(predictedHIValue.toFixed(2)),
        predictedGas: Number(predictedGasValue.toFixed(1)),
        intensity: calculatedIntensity,
        statusMessage,
        alertLevel, // 'none' | 'warning' | 'critical'
        alertMessage, // 알림 메시지 (null이면 알림 없음)
        spo2: 98, lightLux: 500, batteryVoltage: 3.8,
        rawPayload: data,
        createdAt: new Date().toISOString(),
        validated: true
    };

    this.memoryStore[userId] = payload;
    return { success: true, intensity: calculatedIntensity, message: statusMessage };
  }

  async getLatestEnvironmentData(userId: string) {
    return this.memoryStore[userId] || null;
  }

  async resetSession(userId: string) {
    if (this.sessionStore[userId]) {
        delete this.sessionStore[userId];
        console.log(`Session RESET for ${userId}`);
    }
    // Clear intensity history when session resets
    if (this.intensityHistory[userId]) {
        delete this.intensityHistory[userId];
    }
    return { success: true };
  }

  async saveSession(body: any) {
    const { userId, sessionData } = body;
    if (!userId || !sessionData) return { success: false };

    // Clear session from memory
    if (this.sessionStore[userId]) delete this.sessionStore[userId];

    const sessionId = crypto.randomUUID();
    const payload = {
        sessionId, userId, deviceId: null,
        startTime: sessionData.startTime, endTime: sessionData.endTime,
        duration: sessionData.duration, type: 'cardio',
        intensity: sessionData.intensity,
        status: 'completed', metadata: sessionData.metadata,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };

    await this.db.collection('Users').doc(userId).collection('Sessions').doc(sessionId).set(payload);
    return { success: true, sessionId };
  }

  // --- History/Stats Helper ---
  async getSessionDates(userId: string) {
    const s = await this.db.collection('Users').doc(userId).collection('Sessions').select('startTime').get();
    const dates = new Set<string>();
    s.forEach(d => {
        if (d.data().startTime) {
            const kst = new Date(new Date(d.data().startTime).getTime() + 32400000);
            dates.add(kst.toISOString().split('T')[0]);
        }
    });
    return Array.from(dates);
  }

  async getSessionsByDate(userId: string, date: string) {
    const kstStart = new Date(`${date}T00:00:00.000Z`);
    const utcStart = new Date(kstStart.getTime() - 32400000);
    const utcEnd = new Date(utcStart.getTime() + 86399999);
    
    const s = await this.db.collection('Users').doc(userId).collection('Sessions')
        .where('startTime', '>=', utcStart.toISOString())
        .where('startTime', '<=', utcEnd.toISOString())
        .orderBy('startTime', 'desc').get();
    
    return s.docs.map(d => d.data());
  }

  async getStats(userId: string, periodType: 'weekly' | 'monthly') {
    const now = new Date();
    const currentStart = new Date(now);
    const currentEnd = new Date(now);
    
    // Current period
    if (periodType === 'weekly') {
      currentStart.setDate(now.getDate() - 7);
    } else {
      currentStart.setMonth(now.getMonth() - 1);
    }
    
    // Previous period (same length as current)
    // Previous period should be: [currentStart - periodLength, currentStart)
    const previousStart = new Date(currentStart);
    const previousEnd = new Date(currentStart); // Previous period ends where current period starts
    if (periodType === 'weekly') {
      previousStart.setDate(previousStart.getDate() - 7);
      // previousEnd is already currentStart, which is correct
    } else {
      previousStart.setMonth(previousStart.getMonth() - 1);
      // previousEnd is already currentStart, which is correct
    }
    
    // Fetch current period sessions (use >= only, filter in code)
    const currentSessionsQuery = await this.db.collection('Users').doc(userId).collection('Sessions')
        .where('startTime', '>=', currentStart.toISOString())
        .get();
    
    // Fetch previous period sessions
    const previousSessionsQuery = await this.db.collection('Users').doc(userId).collection('Sessions')
        .where('startTime', '>=', previousStart.toISOString())
        .get();
    
    // Filter by end date in code
    const currentSessions = currentSessionsQuery.docs.filter(d => {
      const startTime = d.data().startTime;
      if (!startTime) return false;
      const start = new Date(startTime);
      return start >= currentStart && start <= currentEnd;
    });
    
    const previousSessions = previousSessionsQuery.docs.filter(d => {
      const startTime = d.data().startTime;
      if (!startTime) return false;
      const start = new Date(startTime);
      return start >= previousStart && start < previousEnd; // Use < instead of <= to exclude currentStart
    });

    // Calculate current period stats
    let currentDuration = 0, currentIntensity = 0, currentCount = 0;
    const currentDailyData: Record<string, { duration: number; intensity: number; count: number }> = {};
    
    currentSessions.forEach(d => {
      const data = d.data();
        const duration = Number(data.duration || 0);
        const intensity = Number(data.intensity || 0);
        currentDuration += duration;
        if (intensity > 0) { 
          currentIntensity += intensity; 
          currentCount++; 
        }
        
        // Group by day for graph
        if (data.startTime) {
          const date = new Date(data.startTime).toISOString().split('T')[0];
          if (!currentDailyData[date]) {
            currentDailyData[date] = { duration: 0, intensity: 0, count: 0 };
          }
          currentDailyData[date].duration += duration;
          currentDailyData[date].intensity += intensity;
          currentDailyData[date].count += 1;
        }
    });

    // Calculate previous period stats
    let previousDuration = 0, previousIntensity = 0, previousCount = 0;
    const previousDailyData: Record<string, { duration: number; intensity: number; count: number }> = {};
    
    previousSessions.forEach(d => {
      const data = d.data();
        const duration = Number(data.duration || 0);
        const intensity = Number(data.intensity || 0);
        previousDuration += duration;
        if (intensity > 0) { 
          previousIntensity += intensity; 
          previousCount++; 
        }
        
        // Group by day for graph
        if (data.startTime) {
          const date = new Date(data.startTime).toISOString().split('T')[0];
          if (!previousDailyData[date]) {
            previousDailyData[date] = { duration: 0, intensity: 0, count: 0 };
          }
          previousDailyData[date].duration += duration;
          previousDailyData[date].intensity += intensity;
          previousDailyData[date].count += 1;
        }
    });

    const currentAvgIntensity = currentCount > 0 ? currentIntensity / currentCount : 0;
    const previousAvgIntensity = previousCount > 0 ? previousIntensity / previousCount : 0;
    
    // Calculate differences
    const durationDiff = currentDuration - previousDuration;
    const durationDiffPercent = previousDuration > 0 ? ((durationDiff / previousDuration) * 100) : (currentDuration > 0 ? 100 : 0);
    const intensityDiff = currentAvgIntensity - previousAvgIntensity;
    const intensityDiffPercent = previousAvgIntensity > 0 ? ((intensityDiff / previousAvgIntensity) * 100) : (currentAvgIntensity > 0 ? 100 : 0);
    
    // Generate feedback with numbers
    let feedback = "";
    let feedbackDetails = "";
    
    if (durationDiff > 0) {
      feedback = `운동 시간이 ${Math.round(durationDiff)}분 증가했습니다!`;
      feedbackDetails = `이전 ${periodType === 'weekly' ? '주' : '달'} 대비 ${Math.round(durationDiffPercent)}% 증가 (${Math.round(previousDuration)}분 → ${Math.round(currentDuration)}분)`;
    } else if (durationDiff < 0) {
      feedback = `운동 시간이 ${Math.round(Math.abs(durationDiff))}분 감소했습니다.`;
      feedbackDetails = `이전 ${periodType === 'weekly' ? '주' : '달'} 대비 ${Math.round(Math.abs(durationDiffPercent))}% 감소 (${Math.round(previousDuration)}분 → ${Math.round(currentDuration)}분)`;
    } else {
      feedback = "운동 시간이 유지되었습니다.";
      feedbackDetails = `이전 ${periodType === 'weekly' ? '주' : '달'}와 동일한 ${Math.round(currentDuration)}분`;
    }
    
    if (intensityDiff > 0.5) {
      feedback += ` 평균 운동 강도가 ${Math.round(intensityDiff * 10) / 10} 증가했습니다.`;
      feedbackDetails += ` 평균 강도: ${Math.round(previousAvgIntensity * 10) / 10} → ${Math.round(currentAvgIntensity * 10) / 10} (${Math.round(intensityDiffPercent)}% 증가)`;
    } else if (intensityDiff < -0.5) {
      feedback += ` 평균 운동 강도가 ${Math.round(Math.abs(intensityDiff) * 10) / 10} 감소했습니다.`;
      feedbackDetails += ` 평균 강도: ${Math.round(previousAvgIntensity * 10) / 10} → ${Math.round(currentAvgIntensity * 10) / 10} (${Math.round(Math.abs(intensityDiffPercent))}% 감소)`;
    } else {
      feedback += ` 평균 운동 강도는 유지되었습니다.`;
      feedbackDetails += ` 평균 강도: ${Math.round(currentAvgIntensity * 10) / 10} (변화 없음)`;
    }
    
    // Prepare graph data (daily averages)
    const graphData: { date: string; currentDuration: number; previousDuration: number; currentIntensity: number; previousIntensity: number }[] = [];
    const allDates = new Set([...Object.keys(currentDailyData), ...Object.keys(previousDailyData)]);
    const sortedDates = Array.from(allDates).sort();
    
    sortedDates.forEach(date => {
      const current = currentDailyData[date] || { duration: 0, intensity: 0, count: 0 };
      const previous = previousDailyData[date] || { duration: 0, intensity: 0, count: 0 };
      graphData.push({
        date,
        currentDuration: current.duration,
        previousDuration: previous.duration,
        currentIntensity: current.count > 0 ? current.intensity / current.count : 0,
        previousIntensity: previous.count > 0 ? previous.intensity / previous.count : 0
      });
    });

    return {
        userId, 
        periodType, 
        current: {
          totalDuration: Math.round(currentDuration),
          totalSessions: currentSessions.length,
          avgIntensity: Math.round(currentAvgIntensity * 10) / 10
        },
        previous: {
          totalDuration: Math.round(previousDuration),
          totalSessions: previousSessions.length,
          avgIntensity: Math.round(previousAvgIntensity * 10) / 10
        },
        comparison: {
          durationDiff: Math.round(durationDiff),
          durationDiffPercent: Math.round(durationDiffPercent),
          intensityDiff: Math.round(intensityDiff * 10) / 10,
          intensityDiffPercent: Math.round(intensityDiffPercent)
        },
        feedback,
        feedbackDetails,
        graphData
    };
    }

  async generateMockData(userId: string) {
    const batch = this.db.batch();
    const ref = this.db.collection('Users').doc(userId).collection('Sessions');
    for(let i=0; i<90; i++) {
        if(Math.random()>0.3) continue;
        const d = new Date(); d.setDate(d.getDate()-i);
        const st = d.toISOString();
        const dur = 30+Math.floor(Math.random()*60);
        const id = crypto.randomUUID();
        batch.set(ref.doc(id), {
            sessionId: id, userId, startTime: st, duration: dur,
            intensity: 3+Math.floor(Math.random()*5),
            status: 'completed'
        });
    }
    await batch.commit();
    return { success: true };
}
}