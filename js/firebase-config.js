// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBTdVou_-7Hi2qzRRnxO8YqtjuacHyUeP0",
  authDomain: "bpe-dashboard.firebaseapp.com",
  projectId: "bpe-dashboard",
  storageBucket: "bpe-dashboard.firebasestorage.app",
  messagingSenderId: "448552104061",
  appId: "1:448552104061:web:ad58b53455524be03d4114",
  measurementId: "G-JL46CWNJ01"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
