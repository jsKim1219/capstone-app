// 필요한 모듈 불러오기
const express = require('express');
const path = require('path');
const admin = require('firebase-admin'); // Firebase Admin SDK 불러오기
const axios = require('axios'); // API 요청을 위한 axios 모듈
const fs = require('fs'); // 파일 시스템 모듈
const csv = require('csv-parser'); // CSV 파싱을 위한 모듈

const app = express();

// Firebase 서비스 계정 키 불러오기
// 이 파일은 절대 공개된 GitHub에 올리면 안 됩니다.
const serviceAccount = require('./serviceAccountKey.json');

// Firebase Admin SDK 초기화
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://capstone-55527.firebaseio.com" // YOUR-PROJECT-ID를 본인 프로젝트 ID로 변경
});

// JSON 형식의 요청 본문을 파싱하기 위한 미들웨어
app.use(express.json());

// Render가 지정하는 포트 사용
const PORT = process.env.PORT || 3000;

// 정적 파일 제공
app.use(express.static(path.join(__dirname)));

// 기본 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 새로운 API 엔드포인트: 아두이노 센서 데이터 수신
app.post('/api/sensor-data', (req, res) => {
  try {
    const sensorData = req.body;
    console.log('수신된 센서 데이터:', sensorData);

    // Firebase Realtime Database에 데이터 저장
    const db = admin.database();
    const ref = db.ref('sensor_data'); // 'sensor_data' 경로에 저장
    const newRecordRef = ref.push(); // 새로운 고유 키 생성
    
    newRecordRef.set({
      ...sensorData,
      timestamp: admin.database.ServerValue.TIMESTAMP // 서버 타임스탬프
    });

    res.status(200).json({ message: '데이터가 성공적으로 저장되었습니다.' });
  } catch (error) {
    console.error('데이터 저장 중 오류 발생:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 전력 API 호출 함수
async function fetchPowerData() {
  const url = 'https://www.data.go.kr/data/15039291/fileData.do';
  try {
    const response = await axios.get(url);
    // TODO: 응답 데이터 형식에 맞춰 데이터 파싱 및 처리 로직 추가
    console.log('전력 데이터 API 호출 성공:', response.data);
    return response.data;
  } catch (error) {
    console.error('전력 데이터 API 호출 중 오류 발생:', error);
    return null;
  }
}

// 가스 CSV 파일 파싱 함수
function parseGasCsvData() {
  const filePath = path.join(__dirname, 'csv', 'Monthly_Gas_Usage.csv');
  const results = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        console.log('가스 CSV 파일 파싱 완료:', results);
        resolve(results);
      })
      .on('error', (error) => {
        console.error('가스 CSV 파일 파싱 중 오류 발생:', error);
        reject(error);
      });
  });
}

// 새로운 API 엔드포인트: 사용량 데이터 조회 및 외부 API 호출
app.get('/api/usage-data', async (req, res) => {
  try {
    // Firebase Realtime Database에서 센서 데이터 조회
    const db = admin.database();
    const ref = db.ref('sensor_data');
    const snapshot = await ref.once('value');
    const sensorData = snapshot.val();

    // 외부 전력 API 데이터 호출
    const powerApiData = await fetchPowerData();

    // 로컬 가스 CSV 데이터 파싱
    const gasCsvData = await parseGasCsvData();

    res.status(200).json({
      sensorData,
      powerApiData,
      gasCsvData
    });
  } catch (error) {
    console.error('사용량 데이터 조회 중 오류 발생:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});


// 서버 시작
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
