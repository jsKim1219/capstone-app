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

// ========================================================
// ===        !!! 중요: Firebase 초기화 수정 !!!        ===
// ========================================================
try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountKey),
      databaseURL: "https://capstone-55527-default-rtdb.asia-southeast1.firebasedabase.app",
      storageBucket: "capstone-55527.firebasestorage.app" 
    });
} catch(error) {
    console.error("Firebase 초기화 실패:", error);
}

const PORT = process.env.PORT || 3000;
const db = admin.database();

// --- 데이터 업데이트 관련 함수들 (기존과 동일) ---

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

cron.schedule('0 0 * * *', async () => {
  console.log('스케줄러에 의한 데이터 업데이트 작업을 시작합니다...');
  await updateSingleData();
});


// --- API 엔드포인트들 (기존과 동일) ---

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

app.get('/api/force-update', async (req, res) => {
  console.log('수동으로 실시간 데이터 업데이트 작업을 시작합니다...');
  const success = await updateSingleData();
  if (success) {
    res.status(200).send('<h1>실시간 데이터 추가 성공!</h1><p>오늘 날짜로 새로운 데이터 1건이 추가되었습니다.</p>');
  } else {
    res.status(500).send('<h1>실시간 데이터 추가 실패!</h1><p>Render 로그를 확인해주세요.</p>');
  }
});

app.get('/api/init-historical-data', async (req, res) => {
    console.log('과거 데이터로 데이터베이스 초기화 작업을 시작합니다...');
    try {
        if (!gasDataJson || gasDataJson.length === 0) {
            return res.status(400).send('<h1>초기화 실패</h1><p>gas_data.json 파일이 없거나 비어있습니다.</p>');
        }
        const ref = db.ref('sensor_data');
        await ref.set(null);
        for (const item of gasDataJson) {
            const timestamp = new Date(item.month + '-01').getTime();
            const gasValue = item.average;
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


// ========================================================
// ===        사용자 관리 API 엔드포인트 (일부 수정)     ===
// ========================================================

const usersRef = db.ref('users');

// 1. GET /api/users : 모든 사용자 목록 가져오기 (기존과 동일)
app.get('/api/users', async (req, res) => {
    try {
        const snapshot = await usersRef.once('value');
        res.status(200).json(snapshot.val() || {});
    } catch (error) {
        console.error('사용자 데이터 조회 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 2. POST /api/users : 새 사용자 추가하기 (기존과 동일)
app.post('/api/users', async (req, res) => {
    try {
        const newUserRef = usersRef.push();
        await newUserRef.set(req.body);
        res.status(201).json({ id: newUserRef.key, ...req.body });
    } catch (error) {
        console.error('사용자 추가 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 3. PUT /api/users/:id : 특정 사용자 정보 수정하기 (기존과 동일)
app.put('/api/users/:id', async (req, res) => {
    try {
        await usersRef.child(req.params.id).update(req.body);
        res.status(200).send('사용자 정보가 성공적으로 수정되었습니다.');
    } catch (error) {
        console.error('사용자 수정 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// ========================================================
// ===   !!! 중요: 사용자 삭제 API 수정 (사진 삭제 포함) !!!  ===
// ========================================================
app.delete('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    const userRef = usersRef.child(userId);

    try {
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();

        // 1. 사용자의 이미지 URL이 있는지 확인
        if (userData && userData.imageUrl) {
            const imageUrl = userData.imageUrl;
            
            // 2. 이미지 URL에서 스토리지 파일 경로를 추출
            const filePath = decodeURIComponent(imageUrl.split('/o/')[1].split('?')[0]);
            
            // 3. 스토리지에서 해당 파일 삭제
            const file = admin.storage().bucket().file(filePath);
            await file.delete();
            console.log(`스토리지에서 ${filePath} 파일 삭제 성공`);
        }

        // 4. 데이터베이스에서 사용자 정보 삭제
        await userRef.remove();
        console.log(`데이터베이스에서 사용자 ${userId} 삭제 성공`);

        res.status(200).send('사용자가 성공적으로 삭제되었습니다.');

    } catch (error) {
        // 스토리지에 파일이 없는 등 오류가 발생해도 DB 삭제는 시도
        if (error.code === 404) {
            console.warn('스토리지에 파일이 없어 DB 정보만 삭제합니다.');
            await userRef.remove();
            return res.status(200).send('사용자가 성공적으로 삭제되었습니다 (스토리지에 해당 파일 없음).');
        }
        console.error('사용자 삭제 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});


// 서버 시작
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});