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

// --- 데이터 업데이트 관련 함수 ---
async function accumulateOrPushData(dataToSave) {
  const { electricityValue, gasValue } = dataToSave;
  const ref = db.ref('sensor_data');
  
  try {
    const snapshot = await ref.orderByKey().limitToLast(1).once('value');
    let latestKey = null;

    if (snapshot.exists()) {
      latestKey = Object.keys(snapshot.val())[0];
    }

    if (latestKey) {
      const latestRecordRef = ref.child(latestKey);
      await latestRecordRef.transaction((currentData) => {
        if (currentData === null) return null;
        
        const newTimestamp = admin.database.ServerValue.TIMESTAMP;
        if (!isNaN(electricityValue)) {
          currentData.electricity = currentData.electricity || { value: 0 };
          currentData.electricity.value = (currentData.electricity.value || 0) + electricityValue;
          currentData.electricity.timestamp = newTimestamp;
        }
        if (!isNaN(gasValue)) {
          currentData.gas = currentData.gas || { value: 0 };
          currentData.gas.value = (currentData.gas.value || 0) + gasValue;
          currentData.gas.timestamp = newTimestamp;
        }
        return currentData;
      });
      console.log(`[데이터 누적] (Key: ${latestKey})`, dataToSave);
      return { accumulated: true, key: latestKey };

    } else {
      const newData = {};
      const timestamp = admin.database.ServerValue.TIMESTAMP;
      if (!isNaN(electricityValue)) newData.electricity = { value: electricityValue, timestamp: timestamp };
      if (!isNaN(gasValue)) newData.gas = { value: gasValue, timestamp: timestamp };

      if (Object.keys(newData).length > 0) {
        const newRecordRef = await ref.push(newData);
        console.log(`[새 데이터]`, newData);
        return { accumulated: false, key: newRecordRef.key };
      }
      return { accumulated: false, key: null };
    }
  } catch (error) {
    console.error('데이터 저장 오류:', error);
    throw error;
  }
}

async function updateSingleData() {
  try {
    const powerData = Math.floor(Math.random() * (450 - 250 + 1)) + 250;
    const latestGasData = (gasDataJson.length > 0) ? gasDataJson[gasDataJson.length - 1].average : 0;
    await accumulateOrPushData({ electricityValue: powerData, gasValue: latestGasData });
    return true;
  } catch (error) {
    console.error('스케줄링 업데이트 오류:', error);
    return false;
  }
}

cron.schedule('0 0 * * *', async () => {
  console.log('스케줄러 시작');
  await updateSingleData();
});

/**
 * sensor_data와 test 경로 데이터를 가져와 병합하고 시간순으로 정렬하는 함수
 */
async function fetchAndMergeUsageData(path1, path2) {
    const ref1 = db.ref(path1);
    const ref2 = db.ref(path2);

    const [snapshot1, snapshot2] = await Promise.all([
        ref1.once('value'),
        ref2.once('value').catch(e => {
            console.warn(`경고: ${path2} 경로 조회 중 오류 발생 (무시) - ${e.message}`);
            return null;
        })
    ]);

    const data1 = snapshot1.val() || {};
    const data2 = (snapshot2 && snapshot2.val()) ? snapshot2.val() : {};

    const allData = { ...data1, ...data2 }; 

    const electricityData = [];
    const gasData = [];

    // [수정된 로직] 모든 데이터를 순회하며 다양한 구조 포괄적으로 추출
    Object.keys(allData).forEach(key => {
        const entry = allData[key];
        
        // 1. sensor_data 구조: { electricity: { value, timestamp }, gas: { value, timestamp } }
        if (entry.electricity && entry.electricity.value !== undefined && entry.electricity.timestamp) {
            electricityData.push({ value: entry.electricity.value, timestamp: entry.electricity.timestamp });
        }
        if (entry.gas && entry.gas.value !== undefined && entry.gas.timestamp) {
            gasData.push({ value: entry.gas.value, timestamp: entry.gas.timestamp });
        }
        
        // 2. test 경로에서 들어올 수 있는 구조 (예: { electric_value: X, gas_value: Y, timestamp: Z })
        if (entry.electric_value !== undefined && entry.timestamp) {
             electricityData.push({ value: entry.electric_value, timestamp: entry.timestamp });
        }
        if (entry.gas_value !== undefined && entry.timestamp) {
             gasData.push({ value: entry.gas_value, timestamp: entry.timestamp });
        }
    });

    // timestamp 기준으로 정렬
    electricityData.sort((a, b) => a.timestamp - b.timestamp);
    gasData.sort((a, b) => a.timestamp - b.timestamp);

    return { electricity: electricityData, gas: gasData };
}

/**
 * [수정 완료] realtime_env에서 현재 온습도 및 센서 데이터를 가져옵니다.
 * - 값이 유효한 숫자인지 확인하는 헬퍼 함수를 사용하여 안전성을 높입니다.
 */
function getValidNumber(value) {
    if (value === null || value === undefined) return 0.0;
    const num = parseFloat(value);
    // isFinite는 NaN, Infinity, -Infinity가 아닌지 확인합니다.
    return isFinite(num) ? num : 0.0;
}

async function fetchRealtimeEnvData() {
    const realtimeRef = db.ref('realtime_env');
    const snapshot = await realtimeRef.once('value');
    const data = snapshot.val() || {};
    
    // getValidNumber 함수를 사용하여 데이터가 문자열이거나 유효하지 않은 숫자일 때 0.0을 반환하도록 처리
    return {
        // MainActivity에서 사용하는 필드
        realtime_temp: getValidNumber(data.temp),
        realtime_humidity: getValidNumber(data.humidity),
        
        // UsageActivity에서 사용하는 필드
        realtime_electricity_kwh: getValidNumber(data.electricity_kwh),
        realtime_gas: getValidNumber(data.gas)
    };
}


// --- API 엔드포인트 ---
app.post('/api/sensor-data', async (req, res) => {
  const { electricity, gas } = req.body;
  const electricityValue = parseFloat(electricity);
  const gasValue = parseFloat(gas);

  if (isNaN(electricityValue) && isNaN(gasValue)) {
    return res.status(400).json({ error: '유효한 값이 없습니다.' });
  }

  try {
    const result = await accumulateOrPushData({ electricityValue, gasValue });
    res.status(result.accumulated ? 200 : 201).json({ message: '처리 완료', key: result.key });
  } catch (error) {
    res.status(500).json({ error: '서버 오류' });
  }
});

/**
 * [수정됨] sensor_data, test, 그리고 realtime_env 데이터를 병합하여 반환합니다.
 */
app.get('/api/usage-data', async (req, res) => {
  try {
    // 1. 월별 누적 및 테스트 데이터 가져오기
    const mergedData = await fetchAndMergeUsageData('sensor_data', 'test');
    
    // 2. 실시간 환경 데이터 가져오기 (이제 안전한 값을 반환함)
    const realtimeData = await fetchRealtimeEnvData();
    
    // 3. 두 데이터를 합쳐서 클라이언트에 전송
    const responseData = {
        ...mergedData,
        ...realtimeData // 모든 실시간 필드가 포함됨
    };
    
    res.status(200).json(responseData);
  } catch (error) {
    console.error('Usage data fetch error:', error);
    res.status(500).json({ error: '서버 오류' });
  }
});

app.get('/api/force-update', async (req, res) => {
  const success = await updateSingleData();
  res.status(success ? 200 : 500).send(success ? '성공' : '실패');
});

app.get('/api/init-historical-data', async (req, res) => {
    try {
        if (!gasDataJson || gasDataJson.length === 0) return res.status(400).send('json 파일 없음');
        const ref = db.ref('sensor_data');
        await ref.set(null);
        for (const item of gasDataJson) {
            const timestamp = new Date(item.month + '-01').getTime();
            await ref.push({
                electricity: { value: Math.floor(Math.random() * 200) + 250, timestamp },
                gas: { value: item.average, timestamp }
            });
        }
        res.status(200).send('초기화 성공');
    } catch(error) {
        res.status(500).json({ error: '오류 발생' });
    }
});

// --- 사용자 관리 API ---

const usersRef = db.ref('users');

app.get('/api/users', async (req, res) => {
    try {
        const ownerId = req.query.ownerId; 
        const snapshot = await usersRef.once('value');
        const allUsers = snapshot.val() || {};

        if (ownerId) {
            const filteredUsers = {};
            for (const [key, user] of Object.entries(allUsers)) {
                if (user.ownerId === ownerId || user.id === ownerId) {
                    filteredUsers[key] = user;
                }
            }
            res.status(200).json(filteredUsers);
        } else {
            res.status(200).json(allUsers);
        }
    } catch (error) {
        console.error('사용자 조회 오류:', error);
        res.status(500).json({ error: '서버 오류' });
    }
});

// [수정됨] 회원가입과 단순 사용자 추가 로직 분리 및 ID/Username 중복 검사
app.post('/api/users', async (req, res) => {
    try {
        // 1. 회원가입 (ID, PW, Username 필수)
        if (req.body.id && req.body.password && req.body.username) {
            const { id, username, password } = req.body;
            
            // ID 중복 검사
            const idSnapshot = await usersRef.orderByChild('id').equalTo(id).once('value');
            if (idSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
            
            // Username 중복 검사 
            const usernameSnapshot = await usersRef.orderByChild('username').equalTo(username).once('value');
            if (usernameSnapshot.exists()) return res.status(409).json({ error: '이미 사용 중인 이름입니다.' });

            const newUserRef = usersRef.push();
            await newUserRef.set({ id, username, password }); 
            return res.status(201).json({ id: newUserRef.key, message: '회원가입 성공' });
        } 
        
        // 2. 단순 사용자 추가 (Name, OwnerId 필수, ID/PW 없음)
        else if (req.body.name && req.body.ownerId && !req.body.id && !req.body.password) {
            const newUserRef = usersRef.push();
            const userData = {
                name: req.body.name,
                ownerId: req.body.ownerId, 
                imageUrl: req.body.imageUrl || null
            };
            await newUserRef.set(userData); 
            console.log("단순 사용자 추가됨:", userData.name, "Owner:", userData.ownerId);
            return res.status(201).json({ id: newUserRef.key, message: '사용자 추가 성공' });
        }

        else {
            return res.status(400).json({ error: '필수 정보가 부족하거나 형식이 잘못되었습니다.' });
        }

    } catch (error) {
        console.error('사용자 추가/가입 오류:', error);
        res.status(500).json({ error: '서버 오류' });
    }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        await usersRef.child(req.params.id).update(req.body);
        res.status(200).send('수정 성공');
    } catch (error) {
        res.status(500).json({ error: '오류' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    const userRef = usersRef.child(userId);
    try {
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        if (userData && userData.imageUrl) {
            try {
                const filePath = decodeURIComponent(userData.imageUrl.split('/o/')[1].split('?')[0]);
                await admin.storage().bucket().file(filePath).delete();
            } catch(e) { console.warn('이미지 삭제 실패(무시):', e.message); }
        }
        await userRef.remove();
        res.status(200).send('삭제 성공');
    } catch (error) {
        res.status(500).json({ error: '오류' });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
