use crate::module::ModuleBackend;
pub struct JsonFormatModule;
impl ModuleBackend for JsonFormatModule {
    fn id(&self) -> &'static str {
        "jsonfmt"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
