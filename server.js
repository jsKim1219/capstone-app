// 필요한 모듈 불러오기
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const cron = require('node-cron');

// 로컬 JSON 데이터 불러오기
let gasDataJson = [];
try {
    gasDataJson = require('./csv/gas_data.json');
} catch(e) {
    console.warn("경고: ./csv/gas_data.json 파일을 찾을 수 없습니다.");
}

const app = express();

// Render 환경 변수에서 키 정보 불러오기
let serviceAccountKey;
try {
  serviceAccountKey = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("SERVICE_ACCOUNT_KEY 환경 변수가 올바른 JSON 형식이 아닙니다. Render 대시보드에서 키 값을 다시 확인해주세요.", e);
  process.exit(1);
}

// Firebase Admin SDK 초기화
try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountKey),
      databaseURL: "https://capstone-55527-default-rtdb.asia-southeast1.firebasedatabase.app"
    });
} catch(error) {
    console.error("Firebase 초기화 실패:", error);
}

app.use(express.json());
const PORT = process.env.PORT || 3000;
const db = admin.database();

// --- 데이터 업데이트 관련 함수들 ---

// (1) 오늘 날짜로 새로운 데이터 1건 추가 (기존 force-update 기능)
async function updateSingleData() {
  try {
    const powerData = Math.floor(Math.random() * (450 - 250 + 1)) + 250;
    const latestGasData = (gasDataJson.length > 0) ? gasDataJson[gasDataJson.length - 1].average : 0;

    if (db) {
        const ref = db.ref('sensor_data');
        await ref.push({
          electricity: { value: powerData, timestamp: admin.database.ServerValue.TIMESTAMP },
          gas: { value: latestGasData, timestamp: admin.database.ServerValue.TIMESTAMP }
        });
        console.log('새로운 실시간 데이터 1건이 Firebase에 저장되었습니다.');
        return true;
    }
    return false;
  } catch (error) {
    console.error('실시간 데이터 업데이트 중 오류 발생:', error);
    return false;
  }
}

// 스케줄러: 매일 자정에 새로운 데이터 1건 추가
cron.schedule('0 0 * * *', async () => {
  console.log('스케줄러에 의한 데이터 업데이트 작업을 시작합니다...');
  await updateSingleData();
});


// --- API 엔드포인트들 ---

// API: 사용량 데이터 조회
app.get('/api/usage-data', async (req, res) => {
  try {
    const snapshot = await db.ref('sensor_data').orderByChild('gas/timestamp').once('value');
    const data = snapshot.val();

    if (!data) {
      return res.status(200).json({ electricity: [], gas: [] });
    }

    const electricityData = [];
    const gasData = [];

    Object.keys(data).forEach(key => {
      const entry = data[key];
      if (entry.electricity) {
        electricityData.push({
          timestamp: entry.electricity.timestamp,
          value: entry.electricity.value
        });
      }
      if (entry.gas) {
        gasData.push({
          timestamp: entry.gas.timestamp,
          value: entry.gas.value
        });
      }
    });

    res.status(200).json({ electricity: electricityData, gas: gasData });
  } catch (error) {
    console.error('사용량 데이터 조회 중 오류 발생:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// API: 오늘 날짜로 새 데이터 1건 수동 추가
app.get('/api/force-update', async (req, res) => {
  console.log('수동으로 실시간 데이터 업데이트 작업을 시작합니다...');
  const success = await updateSingleData();
  if (success) {
    res.status(200).send('<h1>실시간 데이터 추가 성공!</h1><p>오늘 날짜로 새로운 데이터 1건이 추가되었습니다.</p>');
  } else {
    res.status(500).send('<h1>실시간 데이터 추가 실패!</h1><p>Render 로그를 확인해주세요.</p>');
  }
});

// (2) API: 전체 과거 데이터로 DB 초기화 (새로 추가된 기능)
app.get('/api/init-historical-data', async (req, res) => {
    console.log('과거 데이터로 데이터베이스 초기화 작업을 시작합니다...');
    try {
        if (!gasDataJson || gasDataJson.length === 0) {
            return res.status(400).send('<h1>초기화 실패</h1><p>gas_data.json 파일이 없거나 비어있습니다.</p>');
        }

        const ref = db.ref('sensor_data');
        // 1. 기존 데이터를 모두 삭제
        await ref.set(null);
        console.log('기존 sensor_data를 삭제했습니다.');

        // 2. gas_data.json의 모든 항목을 Firebase에 저장
        for (const item of gasDataJson) {
            // '2022-01' 같은 문자열을 자바스크립트 날짜 객체로 변환 후 타임스탬프로 저장
            const timestamp = new Date(item.month + '-01').getTime();
            const gasValue = item.average;
            // 각 월에 해당하는 가상 전력 데이터 생성
            const electricityValue = Math.floor(Math.random() * (450 - 250 + 1)) + 250;

            await ref.push({
                electricity: { value: electricityValue, timestamp: timestamp },
                gas: { value: gasValue, timestamp: timestamp }
            });
        }
        
        console.log('gas_data.json의 모든 데이터로 Firebase를 초기화했습니다.');
        res.status(200).send('<h1>데이터베이스 초기화 성공!</h1><p>이제 앱을 다시 실행하여 과거 데이터 차트를 확인해보세요.</p>');

    } catch(error) {
        console.error('데이터베이스 초기화 중 오류 발생:', error);
        res.status(500).send('<h1>데이터베이스 초기화 실패!</h1><p>Render 로그를 확인해주세요.</p>');
    }
});


// 서버 시작
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

