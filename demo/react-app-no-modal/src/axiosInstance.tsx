import axios from "axios";

const axiosInstance = axios.interceptors.request.use((config) => {
  // 添加 token
  const token = localStorage.getItem("token");
  config.headers["jwt_token"] = token;
  return config;
});
export default axiosInstance;
