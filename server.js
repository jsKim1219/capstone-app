// server.js
// 필요한 모듈 불러오기
const express = require('express');
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
app.use(express.json()); // JSON 요청 본문을 파싱하기 위해 추가

// Render 환경 변수에서 키 정보 불러오기
let serviceAccountKey;
try {
  serviceAccountKey = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("SERVICE_ACCOUNT_KEY 환경 변수가 올바른 JSON 형식이 아닙니다. Render 대시보드에서 키 값을 다시 확인해주세요.", e);
  process.exit(1);
}

try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountKey),
      databaseURL: "https://capstone-55527-default-rtdb.asia-southeast1.firebasedatabase.app",
      storageBucket: "capstone-55527.firebasestorage.app" 
    });
} catch(error) {
    console.error("Firebase 초기화 실패:", error);
}

const db = admin.database();
const usersRef = db.ref('users');
const accessLogRef = db.ref('logs/access'); // 로그 참조 추가

const PORT = process.env.PORT || 3000;

// [추가] 가스 데이터 API endpoint (이전 요청에서 유지)
app.get('/api/usage-data', (req, res) => {
    // ... (기존 usage-data 로직 유지) ...
    // 더미 데이터 반환 (실제 구현에 따라 달라질 수 있음)
    res.json({
        "realtime_power_W": 250.5,
        "realtime_gas": 0, // 가스 농도는 이제 실시간 사용하지 않음
        "electricity": [
            { "timestamp": Date.now() - 30 * 24 * 3600 * 1000 * 2, "value": 150.2 }, // 2개월 전
            { "timestamp": Date.now() - 30 * 24 * 3600 * 1000, "value": 180.1 } // 1개월 전
        ],
        "gas": [
            { "timestamp": Date.now() - 30 * 24 * 3600 * 1000 * 2, "value": 1.1 },
            { "timestamp": Date.now() - 30 * 24 * 3600 * 1000, "value": 1.5 }
        ]
    });
});


// -------------------- 사용자 및 등록 관련 API --------------------

// 사용자 추가/가입 (App에서 등록 시)
app.post('/api/users/register', async (req, res) => {
    try {
        // [수정] 등록된 얼굴/음성 데이터 필드 추가
        const { name, ownerId, registered_image_url, registered_voice_level } = req.body; 
        
        if (!name) {
            return res.status(400).json({ error: '사용자 이름은 필수입니다.' });
        }
        
        // 데이터 구조 정의
        const userData = {
            name: name,
            ownerId: ownerId || 'default', 
            is_registered: true,
            // [수정] 등록된 얼굴/음성 데이터 필드 추가 (App에서 전송한다고 가정)
            registered_image_url: registered_image_url || 'https://default-registered-face-url.com', 
            registered_voice_level: registered_voice_level || 70.0, // 기본값 설정 (dB)
            createdAt: admin.database.ServerValue.TIMESTAMP
        };

        // 새로운 사용자 등록
        const newUserRef = usersRef.push();
        await newUserRef.set(userData); 
        
        console.log("새로운 사용자 등록됨:", userData.name);
        return res.status(201).json({ id: newUserRef.key, message: '사용자 등록 성공' });

    } catch (error) {
        console.error('사용자 추가/가입 오류:', error);
        res.status(500).json({ error: '서버 오류' });
    }
});

// ... (나머지 사용자 CRUD API 유지: app.put('/api/users/:id'), app.delete('/api/users/:id'), 등) ...

// ------------------------------------------------------------------

// 서버 시작
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
