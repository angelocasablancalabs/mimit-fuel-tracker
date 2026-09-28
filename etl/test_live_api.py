import json
import requests

# Test su nodo logistico Alessandria (lat: 44.912, lng: 8.615)
# Raggio max consentito dall'API MIMIT: 10 km
PAYLOAD = {
    "points": [{"lat": 44.912, "lng": 8.615}],
    "radius": 10,
    "fuelType": "2-1",  # 2-1 = Gasolio Self-Service
}

URL_LIVE = "https://carburanti.mise.gov.it/ospzApi/search/zone"

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://carburanti.mise.gov.it",
    "Referer": "https://carburanti.mise.gov.it/ospzSearch/zona",
}

print(
    f"Interrogazione LIVE API Ministero in corso (Alessandria, raggio 10 km)..."
)
try:
    resp = requests.post(URL_LIVE, json=PAYLOAD, headers=HEADERS, timeout=15)
    print(f"Status Code: {resp.status_code}")

    if resp.status_code == 200:
        data = resp.json()
        risultati = data.get("results", [])
        print(f"Distributori trovati in tempo reale: {len(risultati)}\n")

        print(
            f"{'NOME / BRAND':<30} | {'PREZZO':<8} | {'ULTIMA COMUNICAZIONE'}"
        )
        print("-" * 65)

        for imp in risultati[:10]:
            nome = (
                imp.get("name")
                or imp.get("brand")
                or imp.get("bandiera")
                or "N/D"
            )
            # Estrazione prezzo gasolio
            prezzo = imp.get("price") or imp.get("prezzo") or "N/D"
            data_comu = (
                imp.get("dIns")
                or imp.get("dtComu")
                or imp.get("insertDate")
                or "N/D"
            )

            print(f"{nome[:30]:<30} | {str(prezzo):<8} | {data_comu}")

        print("-" * 65)
        # Salviamo la risposta raw per analizzare la struttura esatta dei campi
        with open("live_sample.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("Risposta raw salvata in 'live_sample.json' per ispezione.")
    else:
        print(f"Errore dal server: {resp.text}")

except Exception as e:
    print(f"Eccezione durante la chiamata: {e}")