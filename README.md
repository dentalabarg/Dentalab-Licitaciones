# Dentalab Licitaciones

Aplicación web interna para interpretar solicitudes de cotización y licitaciones, extraer renglones y cantidades, proponer uno o varios SKU del catálogo, validar alternativas, guardar aprendizaje e historial, exportar SKU + cantidad y preparar la creación de Pedidos en YiQi.

## Despliegue

El repositorio incluye `render.yaml` y un `Dockerfile` de producción. La aplicación se empaqueta en `Dentalab_Licitaciones_Web_v1.1_GitHub_Render.zip` y el contenedor la extrae durante el build.

Variables secretas requeridas en Render:

- `OPENAI_API_KEY`
- `APP_ACCESS_KEY`

Variables YiQi opcionales hasta cerrar el mapeo:

- `YIQI_USER`
- `YIQI_PASSWORD`

La creación de Pedidos queda deshabilitada inicialmente con `YIQI_ENABLE_CREATE=false`.
