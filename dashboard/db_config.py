
import base64
DB_PASSWORD = base64.b64decode("ENCODED_PASSWORD").decode()
DATABASE_URL = f"postgresql://USER:PASSWORD@localhost:5432/hanmac"
