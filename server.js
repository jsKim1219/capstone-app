// 필요한 모듈 불러오기
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const csv = require('csv-parser');
const cron = require('node-cron');

const app = express();

// Render 환경 변수에서 키 정보 불러오기
const serviceAccountKey = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

// Firebase Admin SDK 초기화
admin.initializeApp({
  credential: admin.credential.cert(serviceAccountKey),
  databaseURL: "https://capstone-55527.firebaseio.com"
});

app.use(express.json());
const PORT = process.env.PORT || 3000;
const db = admin.database();

// 공공기관 API 정보
const powerApiUrl = 'https://www.data.go.kr/data/15039291/fileData.do';
const gasCsvFilePath = path.join(__dirname, 'csv', 'Monthly_Gas_Usage.csv');

// CSV 파일 존재 여부 확인
if (!fs.existsSync(gasCsvFilePath)) {
    console.warn('가스 CSV 파일을 찾을 수 없습니다:', gasCsvFilePath);
}

// 스케줄러: 매일 자정에 실행하여 데이터베이스 업데이트
cron.schedule('0 0 * * *', async () => {
  console.log('데이터 업데이트 작업을 시작합니다...');
  try {
    const powerData = await fetchPowerData();
    const gasData = await parseGasCsvData();

    // Android와 호환되는 데이터 구조로 저장
    const ref = db.ref('sensor_data');
    await ref.push({
      electricity: {
        timestamp: Date.now(),
        value: powerData
      },
      gas: {
        timestamp: Date.now(),
        value: gasData && gasData.length > 0 ? gasData[gasData.length - 1].average : 150
      },
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
    console.log('데이터가 Firebase에 성공적으로 저장되었습니다.');
  } catch (error) {
    console.error('데이터 업데이트 중 오류 발생:', error);
  }
});

// 전력 API 데이터 호출 및 가공 함수 (가상 데이터)
async function fetchPowerData() {
  try {
    // TODO: 실제 API 응답 구조에 맞게 수정 필요
    return 300 + Math.floor(Math.random() * 100); // 가상 전력 사용량 값 (변동성 추가)
  } catch (error) {
    console.error('전력 데이터 API 호출 중 오류 발생:', error);
    return 300; // 기본값
  }
}

// 가스 CSV 파일 파싱 및 월별 평균 계산 함수
function parseGasCsvData() {
  return new Promise((resolve, reject) => {
    // 파일이 존재하지 않으면 기본값 반환
    if (!fs.existsSync(gasCsvFilePath)) {
      console.warn('가스 CSV 파일이 없어 기본값을 반환합니다.');
      resolve([{ month: new Date().toISOString().substring(0, 7), average: 150 }]);
      return;
    }

    const monthlyAverages = {};
    const parser = csv();

    fs.createReadStream(gasCsvFilePath, { encoding: 'cp949' })
      .pipe(parser)
      .on('data', (row) => {
        try {
          const yearMonth = row['연월'] ? row['연월'].substring(0, 7) : null;
          if (!yearMonth) return;

          const regions = Object.keys(row).filter(key => key !== '연월');
          let totalUsage = 0;
          let regionCount = 0;

          regions.forEach(region => {
            const usage = parseFloat(row[region]);
            if (!isNaN(usage)) {
              totalUsage += usage;
              regionCount++;
            }
          });

          if (regionCount > 0) {
            if (!monthlyAverages[yearMonth]) {
              monthlyAverages[yearMonth] = { total: 0, count: 0 };
            }
            monthlyAverages[yearMonth].total += totalUsage / regionCount;
            monthlyAverages[yearMonth].count++;
          }
        } catch (error) {
          console.warn('행 처리 중 오류:', error);
        }
      })
      .on('end', () => {
        const result = Object.keys(monthlyAverages).map(key => ({
          month: key,
          average: monthlyAverages[key].total / monthlyAverages[key].count
        }));
        console.log('가스 CSV 파일 파싱 및 평균 계산 완료.');
        resolve(result);
      })
      .on('error', (error) => {
        console.error('가스 CSV 파일 파싱 중 오류 발생:', error);
        // 오류 발생 시 기본값 반환
        resolve([{ month: new Date().toISOString().substring(0, 7), average: 150 }]);
      });
  });
}

// API 엔드포인트: 사용량 데이터 조회 (Android 호환)
app.get('/api/usage-data', async (req, res) => {
  try {
    const snapshot = await db.ref('sensor_data').limitToLast(30).once('value');
    const data = snapshot.val();

    if (!data) {
      return res.status(404).json({ error: '데이터를 찾을 수 없습니다.' });
    }

    const electricityData = [];
    const gasData = [];

    Object.keys(data).forEach(key => {
      const entry = data[key];
      
      // 새로운 데이터 구조 처리
      if (entry.electricity) {
        electricityData.push({
          timestamp: entry.electricity.timestamp || entry.timestamp,
          value: entry.electricity.value
        });
      }
      
      if (entry.gas) {
        gasData.push({
          timestamp: entry.gas.timestamp || entry.timestamp,
          value: entry.gas.value
        });
      }
      
      // 기존 데이터 구조 호환성 유지
      if (entry.electricityValue !== undefined) {
        electricityData.push({
          timestamp: entry.timestamp,
          value: entry.electricityValue
        });
      }
      
      if (entry.gasValue !== undefined) {
        gasData.push({
          timestamp: entry.timestamp,
          value: entry.gasValue
        });
      }
    });

    res.status(200).json({
      electricity: electricityData,
      gas: gasData
    });
  } catch (error) {
    console.error('사용량 데이터 조회 중 오류 발생:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 헬스체크 엔드포인트
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Server is running'
  });
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});