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

const PORT = process.env.PORT || 3000;
const db = admin.database();

// --- [삭제] 시간 관련 헬퍼 함수 (더 이상 필요 없음) ---

// --- [수정] 데이터 업데이트 관련 함수 (무조건 최신값에 누적) ---

/**
 * [수정] 데이터를 무조건 최신 값에 누적하거나, DB가 비었으면 새로 추가하는 공통 함수
 * @param {object} dataToSave - { electricityValue: number, gasValue: number }
 */
async function accumulateOrPushData(dataToSave) {
  const { electricityValue, gasValue } = dataToSave;
  const ref = db.ref('sensor_data');
  
  try {
    // 1. 가장 최근 데이터를 가져옵니다. (push key 기준 정렬)
    const snapshot = await ref.orderByKey().limitToLast(1).once('value');

    let latestKey = null;

    if (snapshot.exists()) {
      latestKey = Object.keys(snapshot.val())[0];
    }

    // 3. 최근 데이터의 존재 여부로 판단
    if (latestKey) {
      // --- 3-1. 최신 데이터가 있는 경우: 해당 데이터에 누적 (Transaction) ---
      const latestRecordRef = ref.child(latestKey);
      await latestRecordRef.transaction((currentData) => {
        if (currentData === null) {
          return null; // 레코드가 그 사이에 삭제됨. 트랜잭션 중단.
        }
        
        const newTimestamp = admin.database.ServerValue.TIMESTAMP;

        // 전기 값 누적
        if (!isNaN(electricityValue)) {
          currentData.electricity = currentData.electricity || { value: 0 };
          currentData.electricity.value = (currentData.electricity.value || 0) + electricityValue;
          currentData.electricity.timestamp = newTimestamp; // 타임스탬프 업데이트
        }
        
        // 가스 값 누적
        if (!isNaN(gasValue)) {
          currentData.gas = currentData.gas || { value: 0 };
          currentData.gas.value = (currentData.gas.value || 0) + gasValue;
          currentData.gas.timestamp = newTimestamp; // 타임스탬프 업데이트
        }
        
        return currentData; // 수정된 데이터를 반환하여 DB에 저장
      });
      
      console.log(`[최신 데이터 누적 완료] (Key: ${latestKey}):`, dataToSave);
      return { accumulated: true, key: latestKey };

    } else {
      // --- 3-2. DB가 비어있는 경우: 새 데이터 추가 (Push) ---
      const newData = {};
      const timestamp = admin.database.ServerValue.TIMESTAMP;
      
      if (!isNaN(electricityValue)) {
        newData.electricity = { value: electricityValue, timestamp: timestamp };
      }
      if (!isNaN(gasValue)) {
        newData.gas = { value: gasValue, timestamp: timestamp };
      }

      if (Object.keys(newData).length > 0) {
        const newRecordRef = await ref.push(newData);
        console.log(`[새 데이터 추가 완료] (DB 비어있음):`, newData);
        return { accumulated: false, key: newRecordRef.key };
      }
      return { accumulated: false, key: null }; // 유효한 데이터가 없음
    }
  } catch (error) {
    console.error('데이터 저장/누적 중 오류:', error);
    throw error; // 오류를 상위로 전파
  }
}

/**
 * [수정] 스케줄러/테스트용 데이터 생성 함수 (누적 로직 사용)
 */
async function updateSingleData() {
  try {
    // 시뮬레이션용 가짜 데이터 생성
    const powerData = Math.floor(Math.random() * (450 - 250 + 1)) + 250;
    // 기존 로직 유지 (JSON 파일의 마지막 가스 데이터 사용)
    const latestGasData = (gasDataJson.length > 0) ? gasDataJson[gasDataJson.length - 1].average : 0;

    // 공통 함수 호출
    await accumulateOrPushData({
      electricityValue: powerData,
      gasValue: latestGasData
    });
    
    console.log('스케줄링된 데이터 누적/저장 작업을 완료했습니다.');
    return true;
  } catch (error) {
    console.error('스케줄링된 데이터 업데이트 중 오류 발생:', error);
    return false;
  }
}

// 매일 자정마다 데이터 누적/추가
cron.schedule('0 0 * * *', async () => {
  console.log('스케줄러에 의한 데이터 업데이트 작업을 시작합니다...');
  await updateSingleData();
});


// --- API 엔드포인트들 ---

/**
 * [수정] 아두이노(ESP32)에서 실제 센서 데이터를 받아 누적/저장합니다.
 * POST /api/sensor-data
 * 요청 본문(Body) 예시: { "electricity": 0.5, "gas": 0.1 } (누적할 값)
 */
app.post('/api/sensor-data', async (req, res) => {
  const { electricity, gas } = req.body;

  // 데이터 유효성 검사
  const electricityValue = parseFloat(electricity);
  const gasValue = parseFloat(gas);

  if (isNaN(electricityValue) && isNaN(gasValue)) {
    console.error('수신 데이터 오류: 유효한 electricity 또는 gas 값이 없습니다.', req.body);
    return res.status(400).json({ error: '유효한 electricity 또는 gas 값이 필요합니다.' });
  }

  try {
    // 공통 함수 호출
    const result = await accumulateOrPushData({ electricityValue, gasValue });
    
    if (result.accumulated) {
      // 기존 레코드에 누적 성공
      res.status(200).json({ message: '데이터가 성공적으로 누적되었습니다.', key: result.key });
    } else {
      // 새 레코드 생성 성공
      res.status(201).json({ message: '새 데이터가 성공적으로 저장되었습니다.', key: result.key });
    }
  } catch (error) {
    console.error('센서 데이터 저장 중 오류 발생:', error);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// (기존) 앱에서 사용량 데이터를 요청하는 API
app.get('/api/usage-data', async (req, res) => {
  try {
    // 정렬 기준을 'gas/timestamp' -> 'electricity/timestamp'로 변경 (더 안정적일 수 있음)
    // 또는 .orderByKey()를 사용해도 됩니다.
    const snapshot = await db.ref('sensor_data').orderByChild('electricity/timestamp').once('value');
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

// (기존) 테스트용: 데이터를 수동으로 누적/추가하는 API
app.get('/api/force-update', async (req, res) => {
  console.log('수동으로 실시간 데이터 업데이트 작업을 시작합니다...');
  const success = await updateSingleData();
  if (success) {
    res.status(200).send('<h1>실시간 데이터 누적/추가 성공!</h1><p>데이터가 성공적으로 처리되었습니다.</p>');
  } else {
    res.status(500).send('<h1>실시간 데이터 누적/추가 실패!</h1><p>Render 로그를 확인해주세요.</p>');
  }
});

// (기존) 테스트용: DB를 과거 데이터로 초기화하는 API
app.get('/api/init-historical-data', async (req, res) => {
    console.log('과거 데이터로 데이터베이스 초기화 작업을 시작합니다...');
    try {
        if (!gasDataJson || gasDataJson.length === 0) {
            return res.status(400).send('<h1>초기화 실패</h1><p>gas_data.json 파일이 없거나 비어있습니다.</p>');
        }
        const ref = db.ref('sensor_data');
        await ref.set(null); // DB 초기화
        for (const item of gasDataJson) {
            const timestamp = new Date(item.month + '-01').getTime();
            const gasValue = item.average;
            const electricityValue = Math.floor(Math.random() * (450 - 250 + 1)) + 250;
            // 초기화 시에는 누적 로직이 아닌, 개별 push 사용
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


// --- 사용자 관리 API 엔드포인트들 (기존과 동일) ---

const usersRef = db.ref('users');

app.get('/api/users', async (req, res) => {
    try {
        const snapshot = await usersRef.once('value');
        res.status(200).json(snapshot.val() || {});
    } catch (error) {
        console.error('사용자 데이터 조회 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

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

app.put('/api/users/:id', async (req, res) => {
    try {
        await usersRef.child(req.params.id).update(req.body);
        res.status(200).send('사용자 정보가 성공적으로 수정되었습니다.');
    } catch (error) {
        console.error('사용자 수정 오류:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    const userRef = usersRef.child(userId);

    try {
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();

        if (userData && userData.imageUrl) {
            const imageUrl = userData.imageUrl;
            const filePath = decodeURIComponent(imageUrl.split('/o/')[1].split('?')[0]);
            const file = admin.storage().bucket().file(filePath);
            await file.delete();
            console.log(`스토리지에서 ${filePath} 파일 삭제 성공`);
        }

        await userRef.remove();
        console.log(`데이터베이스에서 사용자 ${userId} 삭제 성공`);
        res.status(200).send('사용자가 성공적으로 삭제되었습니다.');

    } catch (error) {
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
