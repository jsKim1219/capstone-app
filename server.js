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

// 스케줄러: 매일 자정에 실행하여 데이터베이스 업데이트
cron.schedule('0 0 * * *', async () => {
  console.log('스케줄러에 의한 데이터 업데이트 작업을 시작합니다...');
  await updateData();
});

// 데이터 업데이트 로직을 별도 함수로 분리
async function updateData() {
  try {
    const powerData = await fetchPowerData(); // 전기 사용량
    const gasData = getLatestGasData(); // 가스 사용량

    if (db) {
        const ref = db.ref('sensor_data');
        await ref.push({
          electricity: {
            value: powerData,
            timestamp: admin.database.ServerValue.TIMESTAMP
          },
          gas: {
            value: gasData,
            timestamp: admin.database.ServerValue.TIMESTAMP
          }
        });
        console.log('데이터가 Firebase에 성공적으로 저장되었습니다.');
        return true;
    } else {
        console.error("데이터베이스가 초기화되지 않았습니다.");
        return false;
    }
  } catch (error) {
    console.error('데이터 업데이트 중 오류 발생:', error);
    return false;
  }
}

// 전력 API 데이터 호출 및 가공 함수 (가상 데이터)
async function fetchPowerData() {
  // 현재는 임의의 값을 반환합니다.
  return Math.floor(Math.random() * (450 - 250 + 1)) + 250;
}

// 로컬 JSON 파일에서 최신 가스 사용량 데이터 가져오는 함수
function getLatestGasData() {
  if (!gasDataJson || gasDataJson.length === 0) {
    console.warn('경고: 가스 데이터가 비어있습니다. 0을 반환합니다.');
    return 0; // 데이터가 없을 경우 0을 반환
  }
  // 가장 마지막 달의 평균값을 반환
  const latestData = gasDataJson[gasDataJson.length - 1];
  return latestData.average;
}

// API 엔드포인트: 사용량 데이터 조회
app.get('/api/usage-data', async (req, res) => {
  try {
    const snapshot = await db.ref('sensor_data').orderByKey().limitToLast(30).once('value');
    const data = snapshot.val();

    if (!data) {
      // 데이터가 없을 때 빈 배열을 반환하도록 수정
      return res.status(200).json({ electricity: [], gas: [] });
    }

    const electricityData = [];
    const gasData = [];

    Object.keys(data).forEach(key => {
      const entry = data[key];
      if (entry.electricity && entry.electricity.value !== undefined) {
        electricityData.push({
          timestamp: entry.electricity.timestamp,
          value: entry.electricity.value
        });
      }
      if (entry.gas && entry.gas.value !== undefined) {
        gasData.push({
          timestamp: entry.gas.timestamp,
          value: entry.gas.value
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

// === 테스트용 엔드포인트 추가 ===
// 이 주소로 접속하면 수동으로 데이터 업데이트를 시도합니다.
app.get('/api/force-update', async (req, res) => {
  console.log('수동으로 데이터 업데이트 작업을 시작합니다...');
  const success = await updateData();
  if (success) {
    res.status(200).send('<h1>데이터 업데이트 성공!</h1><p>Firebase 데이터베이스를 확인해보세요.</p>');
  } else {
    res.status(500).send('<h1>데이터 업데이트 실패!</h1><p>Render 대시보드에서 로그를 확인해주세요.</p>');
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

